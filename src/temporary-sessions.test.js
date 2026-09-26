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

  it('a name containing "." spawns AND saves — the derived id is dot-free, so has-session finds the session tmux actually created (WARDEN-1422 QA blocking 1)', async () => {
    // "release train 0.1.75" is the ticket's own example name. tmux rewrites
    // `.` to `_` in session names, so a derived id that KEEPS the dot names a
    // session tmux does not have: has-session missed, the spawn was misreported
    // as "died immediately", and the REAL session leaked as an orphan. The id
    // must therefore be dot-free — byte-identical to what tmux created — while
    // the display name keeps the dot.
    const NAME = 'release train 0.1.75';
    const DERIVED = 'release-train-0-1-75';
    // Exact-name pre-kill only (never a pattern — the worker sandbox rule), so a
    // leftover from an interrupted earlier run cannot "duplicate session" 500 us.
    spawnSync('tmux', ['kill-session', '-t', DERIVED], { stdio: 'ignore' });
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', cwd: '/tmp', name: NAME, cmd: 'sleep 300' }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    assert.equal(body.chat.session, DERIVED, 'the id is dot-free (tmux rewrites `.` to `_` at creation)');
    assert.equal(body.chat.name, NAME, 'the display name keeps the dot');
    // The spawn-time has-session check passed — the chat answers active, and the
    // session tmux actually created is reachable under the id we derived.
    assert.equal(body.chat.active, true);
    const listed = (await (await fetch(`${baseUrl}/api/chats`)).json()).chats;
    assert.ok(listed.some((c) => c.session === DERIVED), 'a named spawn is persistent: listed under its host');
    const entry = readCatalog().find((e) => e.session === DERIVED);
    assert.ok(entry, 'the catalog entry exists under the dot-free id');
    assert.equal(entry.name, NAME, 'the catalog keeps the human-typed display name');
  });

  it('an EXPLICIT session id containing "." is rejected 400 up front (the same tmux-rewrite hazard, WARDEN-1422 QA) — no tmux session, no catalog entry', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: 'release-train-0.1.75', cwd: '/tmp', cmd: 'sleep 300' }));
    const body = await res.json();
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body?.error || ''}`);
    assert.match(body.error, /invalid session name/);
    assert.ok(!readCatalog().some((e) => e.session === 'release-train-0.1.75'), 'nothing was cataloged');
    assert.ok(!readCatalog().some((e) => e.session === 'release-train-0_1_75'), 'no tmux-rewritten ghost was cataloged either');
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

  it('a FAILED local aliveness probe keeps the temporary entry (unknown is not stopped)', async () => {
    // The GC gate (WARDEN-1422 rework review finding): list-sessions failing —
    // broken tmux, spawn error, connect blip — reports NOTHING. Its empty set
    // is "could not ask", never "confirmed stopped"; GC-ing on it stripped
    // RUNNING unnamed shells from chats.json, leaving live panes unresolvable
    // and unsavable. Injected seam: the probe fails → the entry must survive.
    const { discoverHost } = await import('./chats.js');
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: `${RUN}probeless`, name: `${RUN}probeless`, cwd: '/tmp', cmd: '', temporary: true },
    ]);
    await discoverHost('(local)', {}, { localAliveSessions: async () => ({ ok: false, alive: new Set() }) });
    assert.ok(readCatalog().some((e) => e.session === `${RUN}probeless`), 'a failed local probe must not GC the temporary entry');
  });

  it('an ANSWERED local probe reporting NOTHING alive still GCs (the round-2 finding: no-server is an answer)', async () => {
    // Round-2 review: `list-sessions` exits 1 in TWO situations, and the
    // round-2 fix classified BOTH as "the probe did not answer" — so on a
    // machine whose tmux server has shut down (the ordinary state after the
    // last session ends), a dead temp was never collected and kept being
    // reported as "running here as a pane". "No server running" is a
    // SUCCESSFUL probe of an empty world: ok: true, empty alive set, GC runs.
    // This pins the discoverHost gate on the CLASSIFIED answer (ok: true +
    // empty set → collect); the real classification is pinned separately
    // below through runLocalTmux's result shape.
    const { discoverHost } = await import('./chats.js');
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: `${RUN}serverless`, name: `${RUN}serverless`, cwd: '/tmp', cmd: '', temporary: true },
    ]);
    const { chats } = await discoverHost('(local)', {}, {
      localAliveSessions: async () => ({ ok: true, alive: new Set() }),
    });
    assert.ok(!readCatalog().some((e) => e.session === `${RUN}serverless`),
      'a dead temp on a serverless machine IS collected — the no-server answer is an answer');
    assert.ok(!chats.some((c) => c.session === `${RUN}serverless`),
      'the collected temp does not ride the discover response either');
    // Saved sessions on the same serverless machine are NOT collected — the
    // stopped-saved row is the respawn row, the point of the saved list.
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: `${RUN}savedstopped`, name: `${RUN}savedstopped`, cwd: '/tmp', cmd: '' },
    ]);
    await discoverHost('(local)', {}, { localAliveSessions: async () => ({ ok: true, alive: new Set() }) });
    assert.ok(readCatalog().some((e) => e.session === `${RUN}savedstopped`),
      'a stopped SAVED session survives (respawn target), only temps are collected');
  });

  it('localAliveSessions classifies tmux\'s no-server answers as ANSWERED-empty, never as a failed probe', async () => {
    // The classification itself, driven through runLocalTmux's result SHAPE via
    // the transport seam — both real tmux wordings and the native-Windows one
    // (winsession.js emits `no server running` for the same state).
    const { localAliveSessions } = await import('./chats.js');
    for (const stderr of [
      'no server running on /tmp/tmux-1000/default\n',
      'no server running\n',
      'error connecting to /tmp/tmux-1000/default (No such file or directory)\n',
    ]) {
      const r = await localAliveSessions(async () => ({ ok: false, code: 1, stdout: '', stderr }));
      assert.equal(r.ok, true, `expected ANSWERED for stderr ${JSON.stringify(stderr)}`);
      assert.equal(r.alive.size, 0, `expected an empty alive set for stderr ${JSON.stringify(stderr)}`);
    }
  });

  it('localAliveSessions keeps ok:false for genuine probe failures (spawn error, timeout, other stderr)', async () => {
    const { localAliveSessions } = await import('./chats.js');
    for (const shape of [
      { ok: false, code: -1, stdout: '', stderr: 'spawn tmux ENOENT' },
      { ok: false, code: -1, stdout: '', stderr: '' },
      { ok: false, code: 1, stdout: '', stderr: 'tmux: unknown option -- F' },
      { ok: false, code: 255, stdout: '', stderr: 'Connection reset by peer' },
      { ok: true, code: 0, stdout: 'one-session\n', stderr: '' },
    ]) {
      const r = await localAliveSessions(async () => shape);
      assert.equal(r.ok, shape.ok, `expected ok:${shape.ok} passthrough for ${JSON.stringify(shape)}`);
    }
  });

  it('a failed REMOTE probe keeps the temporary entry and reads unknown, not stopped', async () => {
    // Remote seam of the same gate: discover() answers (host reachable) but the
    // has-session probe blips — the exact split the old code flattened into
    // "every entry dead". discoverManual must hydrate active: null (the
    // toCatalogChat unknown model), and the GC (strict === false) must skip it.
    const { discoverHost } = await import('./chats.js');
    const HOST = 'w1422-remote-host';
    seedCatalog([
      { kind: 'tmux', host: HOST, session: `${RUN}rmt`, name: `${RUN}rmt`, cwd: '/tmp', cmd: '', temporary: true },
    ]);
    const deps = {
      discover: async () => ({ host: HOST, ok: true, chats: [] }),
      // Pin the DEFAULT transport (the boot-applied persisted toggle would
      // otherwise route the probe over the companion channel, where it has no
      // seam): the probe rides runWithPool, which we fail on purpose.
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: false, code: 255, stdout: '', stderr: 'ssh: transient blip' }),
    };
    const { chats } = await discoverHost(HOST, {}, deps);
    assert.ok(readCatalog().some((e) => e.session === `${RUN}rmt`), 'a failed remote probe must not GC the temporary entry');
    const chat = chats.find((c) => c.session === `${RUN}rmt`);
    assert.ok(chat, 'the entry still resolves');
    assert.equal(chat.active, null, 'an unanswered probe reads unknown (null), not stopped (false)');
  });

  it('an ANSWERED remote probe that reports the session dead still GCs the temporary entry', async () => {
    // Positive control for the gate above: a SUCCESSFUL probe positively
    // reporting the session gone is still "temporary + stopped → gone
    // permanently". The happy-dead path keeps working.
    const { discoverHost } = await import('./chats.js');
    const HOST = 'w1422-remote-host';
    seedCatalog([
      { kind: 'tmux', host: HOST, session: `${RUN}rmtdead`, name: `${RUN}rmtdead`, cwd: '/tmp', cmd: '', temporary: true },
    ]);
    const deps = {
      discover: async () => ({ host: HOST, ok: true, chats: [] }),
      // Same transport pin as above: the probe must ride the injected
      // runWithPool seam, not the companion channel.
      isCompanionTransportEnabled: () => false,
      runWithPool: async () => ({ ok: true, code: 0, stdout: `0 ${RUN}rmtdead\n`, stderr: '' }),
    };
    const { chats } = await discoverHost(HOST, {}, deps);
    assert.ok(!readCatalog().some((e) => e.session === `${RUN}rmtdead`), 'a positively-answered dead temporary is still gone for good');
    assert.ok(!chats.some((c) => c.session === `${RUN}rmtdead`), 'the dead temp does not ride the response either');
  });
});
