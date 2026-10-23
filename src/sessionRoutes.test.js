import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// WARDEN-1918 — pins createSessionRouter (src/sessionRoutes.js, the human
// session-lifecycle routes WARDEN-1868 moved out of server.js with no spec of
// its own): /api/rename, /api/save-session, /api/spawn, /api/resume, /api/kill,
// /api/session-kill and /api/respawn. The server-level suites reach these
// routes but leave the input validation, the exact catalog side effects, the
// tmux kill/spawn ordering and the failure channels unasserted.
//
// A UNIT harness: the REAL router mounted on a bare express() app (never
// server.js). HOME is frozen to a temp dir BEFORE the dynamic imports (config.js
// and activity.js compute their paths from os.homedir() at load). A fake `tmux`
// on PATH logs every argv (\037-separated) and models session liveness with
// marker files: new-session creates `alive/<name>`, kill-session removes it,
// has-session answers from it. `new_fail` makes new-session exit non-zero and
// `new_dies` makes it exit 0 WITHOUT creating the session (the "inner command
// failed to start" case). resolve / preflightTmux are injected fakes.
// CLAUDE_CODE_EXECPATH points at a stub file so a bare `claude` cmd resolves
// without a real claude install.

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  COMPANION: process.env.WARDEN_COMPANION_TRANSPORT,
  EXECPATH: process.env.CLAUDE_CODE_EXECPATH,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sessionRoutes-'));
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.WARDEN_COMPANION_TRANSPORT;

const shimDir = path.join(tmpRoot, 'bin');
const stateDir = path.join(tmpRoot, 'state');
const aliveDir = path.join(stateDir, 'alive');
const logFile = path.join(stateDir, 'calls.log');
const newFailFile = path.join(stateDir, 'new_fail');
const newDiesFile = path.join(stateDir, 'new_dies');
fs.mkdirSync(shimDir, { recursive: true });
fs.mkdirSync(aliveDir, { recursive: true });
fs.writeFileSync(logFile, '');

const TMUX_SHIM = `#!/bin/bash
printf -v line '%s\\037' "$@"
printf '%s\\n' "$line" >> "${logFile}"
target=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ] || [ "$prev" = "-s" ]; then target="$a"; fi
  prev="$a"
done
case "$1" in
  has-session)
    [ -f "${aliveDir}/$target" ] && exit 0
    exit 1 ;;
  new-session)
    if [ -f "${newFailFile}" ]; then echo "boom: cannot create" >&2; exit 1; fi
    if [ ! -f "${newDiesFile}" ]; then : > "${aliveDir}/$target"; fi
    exit 0 ;;
  kill-session)
    rm -f "${aliveDir}/$target"
    exit 0 ;;
  *) exit 0 ;;
esac
`;
fs.writeFileSync(path.join(shimDir, 'tmux'), TMUX_SHIM);
fs.chmodSync(path.join(shimDir, 'tmux'), 0o755);
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const claudeStub = path.join(tmpRoot, 'claude-stub');
fs.writeFileSync(claudeStub, '#!/bin/sh\nexit 0\n');
fs.chmodSync(claudeStub, 0o755);
const spacedDir = path.join(tmpRoot, 'Program Files');
fs.mkdirSync(spacedDir, { recursive: true });
const claudeSpaced = path.join(spacedDir, 'claude-stub');
fs.writeFileSync(claudeSpaced, '#!/bin/sh\nexit 0\n');
fs.chmodSync(claudeSpaced, 0o755);
process.env.CLAUDE_CODE_EXECPATH = claudeStub;

const { createSessionRouter } = await import('./sessionRoutes.js');
const { loadCatalog, saveCatalog } = await import('./config.js');
const { readEvents } = await import('./activity.js');

const LOCAL = '(local)';
const REMOTE = 'user@other.example';
const activityFile = path.join(process.env.HOME, '.yatfa-warden', 'activity.jsonl');

const calls = () => fs.readFileSync(logFile, 'utf8')
  .split('\n').filter((l) => l.length > 0)
  .map((l) => l.split('\x1f').slice(0, -1));
const subcommands = () => calls().map((a) => a[0]);
const callsOf = (sub) => calls().filter((a) => a[0] === sub);
const markAlive = (name) => fs.writeFileSync(path.join(aliveDir, name), '');
const isAlive = (name) => fs.existsSync(path.join(aliveDir, name));
const tmuxArgs = (sub) => callsOf(sub)[0];

let chatsById;
let preflightError;
let preflightCalls;
let server;
let base;

const cfg = {};
const resolve = async (id) => {
  const chat = chatsById[id];
  return chat ? { chat } : { error: `no chat matches "${id}"` };
};
const preflightTmux = async (host) => { preflightCalls.push(host); return preflightError; };

const post = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(createSessionRouter({
    cfg, local: LOCAL, resolve, preflightTmux,
    save: async () => {}, afterSave: () => {}, afterSaveDeps: {},
  }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of [['HOME', originalEnv.HOME], ['PATH', originalEnv.PATH],
    ['WARDEN_COMPANION_TRANSPORT', originalEnv.COMPANION], ['CLAUDE_CODE_EXECPATH', originalEnv.EXECPATH]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.CLAUDE_CODE_EXECPATH = claudeStub;
  chatsById = {};
  preflightError = null;
  preflightCalls = [];
  fs.writeFileSync(logFile, '');
  for (const f of fs.readdirSync(aliveDir)) fs.rmSync(path.join(aliveDir, f));
  fs.rmSync(newFailFile, { force: true });
  fs.rmSync(newDiesFile, { force: true });
  fs.rmSync(activityFile, { recursive: true, force: true });
  await saveCatalog([]);
});

const tmuxChat = (session, extra = {}) => ({
  id: `${LOCAL}:${session}`, key: session, kind: 'tmux', host: LOCAL, container: null,
  session, name: session, cwd: '/tmp', cmd: 'bash', role: 'claude', ...extra,
});

describe('POST /api/rename', () => {
  it('trims the name, caps it at 60 chars and persists it on the matching entry', async () => {
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'a', name: 'old', cwd: '/', cmd: '' }]);
    const long = 'x'.repeat(80);
    const r = await post('/api/rename', { session: 'a', name: `   ${long}   ` });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    const [entry] = await loadCatalog();
    assert.equal(entry.name, 'x'.repeat(60));
  });

  it('400s "session and name required" when the session is missing or the name is blank after trimming', async () => {
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'a', name: 'old' }]);
    const noSession = await post('/api/rename', { name: 'n' });
    assert.deepEqual(noSession, { status: 400, body: { error: 'session and name required' } });
    const blankName = await post('/api/rename', { session: 'a', name: '   ' });
    assert.deepEqual(blankName, { status: 400, body: { error: 'session and name required' } });
    assert.equal((await loadCatalog())[0].name, 'old');
  });

  it('404s "not a renameable chat" when no catalog entry matches and writes nothing', async () => {
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'a', name: 'old' }]);
    const r = await post('/api/rename', { session: 'ghost', name: 'n' });
    assert.deepEqual(r, { status: 404, body: { error: 'not a renameable chat' } });
    assert.equal((await loadCatalog())[0].name, 'old');
  });

  it('scopes the rename to host+session: the same session name on another host is untouched', async () => {
    await saveCatalog([
      { kind: 'tmux', host: LOCAL, session: 'dup', name: 'local-name' },
      { kind: 'tmux', host: REMOTE, session: 'dup', name: 'remote-name' },
    ]);
    const r = await post('/api/rename', { session: 'dup', host: REMOTE, name: 'renamed' });
    assert.equal(r.status, 200);
    const cat = await loadCatalog();
    assert.equal(cat.find((c) => c.host === REMOTE).name, 'renamed');
    assert.equal(cat.find((c) => c.host === LOCAL).name, 'local-name');
  });

  it('a whitespace-only host defaults to the local host', async () => {
    await saveCatalog([
      { kind: 'tmux', host: LOCAL, session: 'dup', name: 'local-name' },
      { kind: 'tmux', host: REMOTE, session: 'dup', name: 'remote-name' },
    ]);
    const r = await post('/api/rename', { session: 'dup', host: '   ', name: 'renamed' });
    assert.equal(r.status, 200);
    const cat = await loadCatalog();
    assert.equal(cat.find((c) => c.host === LOCAL).name, 'renamed');
    assert.equal(cat.find((c) => c.host === REMOTE).name, 'remote-name');
  });
});

describe('POST /api/save-session', () => {
  it('passes a resolve error through as a 404', async () => {
    const r = await post('/api/save-session', { id: 'nope' });
    assert.deepEqual(r, { status: 404, body: { error: 'no chat matches "nope"' } });
  });

  it('400s for a non-tmux chat', async () => {
    chatsById.y = { id: 'y', kind: 'yatfa', host: LOCAL, session: 'agent' };
    const r = await post('/api/save-session', { id: 'y' });
    assert.deepEqual(r, { status: 400, body: { error: 'only spawned shell sessions can be saved' } });
  });

  it('404s "no saved session matches this id" when the catalog has no entry for the chat', async () => {
    chatsById.t = tmuxChat('t');
    const r = await post('/api/save-session', { id: 't' });
    assert.deepEqual(r, { status: 404, body: { error: 'no saved session matches this id' } });
  });

  it('clears the temporary flag on the entry, returns the chat with temporary:false, leaves siblings alone', async () => {
    chatsById.t = tmuxChat('t', { temporary: true });
    await saveCatalog([
      { kind: 'tmux', host: LOCAL, session: 't', name: 't', cwd: '/tmp', cmd: '', temporary: true },
      { kind: 'tmux', host: REMOTE, session: 't', name: 't', cwd: '/tmp', cmd: '', temporary: true },
    ]);
    const r = await post('/api/save-session', { id: 't' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.chat.temporary, false);
    assert.equal(r.body.chat.session, 't');
    const cat = await loadCatalog();
    assert.equal(cat.find((c) => c.host === LOCAL).temporary, false);
    assert.equal(cat.find((c) => c.host === REMOTE).temporary, true);
  });

  it('saving an already-saved entry is an idempotent ok', async () => {
    chatsById.t = tmuxChat('t');
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 't', name: 't' }]);
    const r = await post('/api/save-session', { id: 't' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.temporary, false);
  });
});

describe('POST /api/kill', () => {
  it('passes a resolve error through as a 404 and runs no tmux', async () => {
    const r = await post('/api/kill', { id: 'nope' });
    assert.equal(r.status, 404);
    assert.deepEqual(calls(), []);
  });

  it('kills the tmux session, drops only the same host+session catalog entry and records a killed event', async () => {
    chatsById.k = tmuxChat('k', { name: 'Kay', role: 'claude' });
    markAlive('k');
    await saveCatalog([
      { kind: 'tmux', host: LOCAL, session: 'k', name: 'Kay' },
      { kind: 'tmux', host: REMOTE, session: 'k', name: 'remote k' },
      { kind: 'tmux', host: LOCAL, session: 'other', name: 'other' },
    ]);
    const r = await post('/api/kill', { id: 'k' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.deepEqual(tmuxArgs('kill-session'), ['kill-session', '-t', 'k']);
    assert.equal(isAlive('k'), false);
    const cat = await loadCatalog();
    assert.deepEqual(cat.map((c) => `${c.host}:${c.session}`).sort(), [`${LOCAL}:other`, `${REMOTE}:k`].sort());
    const events = await readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'killed');
    assert.equal(events[0].id, `${LOCAL}:k`);
    assert.equal(events[0].host, LOCAL);
    assert.equal(events[0].container, null);
    assert.equal(events[0].name, 'Kay');
  });

  it('a yatfa chat is killed in tmux but the catalog is left alone, and the event name falls back to the container', async () => {
    chatsById.y = { id: 'y', key: 'yatfa-w', kind: 'yatfa', host: LOCAL, container: 'yatfa-worker-1', session: 'agent', role: 'worker' };
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'agent', name: 'unrelated' }]);
    const r = await post('/api/kill', { id: 'y' });
    assert.equal(r.status, 200);
    assert.deepEqual(tmuxArgs('kill-session'), ['kill-session', '-t', 'agent']);
    assert.equal((await loadCatalog()).length, 1);
    const [ev] = await readEvents();
    assert.equal(ev.container, 'yatfa-worker-1');
    assert.equal(ev.name, 'yatfa-worker-1');
    assert.equal(ev.role, 'worker');
  });

  it('still answers ok when the tmux session is already gone', async () => {
    chatsById.gone = tmuxChat('gone');
    const r = await post('/api/kill', { id: 'gone' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
  });

  it('an unwritable activity log does not turn a completed kill into a 500', async () => {
    chatsById.k = tmuxChat('k');
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'k', name: 'k' }]);
    fs.mkdirSync(activityFile, { recursive: true }); // append now fails with EISDIR
    const r = await post('/api/kill', { id: 'k' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.deepEqual(await loadCatalog(), []);
  });
});

describe('POST /api/session-kill', () => {
  it('passes a resolve error through as a 404 and runs no tmux', async () => {
    const r = await post('/api/session-kill', { id: 'nope' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'no chat matches "nope"' });
    assert.deepEqual(calls(), []);
  });

  it('force-kills the tmux session but KEEPS the catalog entry and records no event', async () => {
    chatsById.s = tmuxChat('s');
    markAlive('s');
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 's', name: 's' }]);
    const r = await post('/api/session-kill', { id: 's' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.deepEqual(tmuxArgs('kill-session'), ['kill-session', '-t', 's']);
    assert.equal(isAlive('s'), false);
    assert.equal((await loadCatalog()).length, 1);
    assert.deepEqual(await readEvents(), []);
  });
});

describe('POST /api/respawn', () => {
  it('passes a resolve error through as a 404', async () => {
    const r = await post('/api/respawn', { id: 'nope' });
    assert.equal(r.status, 404);
    assert.deepEqual(calls(), []);
  });

  it('400s for a non-tmux chat and for a tmux chat with no cmd at all', async () => {
    const msg = 'this chat has no command to re-spawn (only spawned tmux chats can be re-spawned)';
    chatsById.y = { id: 'y', kind: 'yatfa', host: LOCAL, session: 'agent', cmd: 'x' };
    chatsById.nocmd = tmuxChat('nocmd', { cmd: undefined });
    chatsById.nullcmd = tmuxChat('nullcmd', { cmd: null });
    for (const id of ['y', 'nocmd', 'nullcmd']) {
      assert.deepEqual(await post('/api/respawn', { id }), { status: 400, body: { error: msg } }, id);
    }
    assert.deepEqual(calls(), []);
    assert.deepEqual(preflightCalls, []);
  });

  it('an EMPTY stored cmd is a valid respawn (the login shell): kill-session then new-session with no command args', async () => {
    chatsById.sh = tmuxChat('sh', { cmd: '', cwd: '/tmp' });
    markAlive('sh');
    const r = await post('/api/respawn', { id: 'sh' });
    assert.deepEqual(r, { status: 200, body: { ok: true } });
    assert.deepEqual(subcommands().filter((s) => s !== 'has-session'), ['kill-session', 'new-session']);
    assert.deepEqual(tmuxArgs('new-session'), ['new-session', '-d', '-s', 'sh', '-x', '120', '-y', '32', '-c', '/tmp']);
    assert.equal(isAlive('sh'), true);
  });

  it('400s with the preflight error before touching tmux', async () => {
    chatsById.p = tmuxChat('p');
    preflightError = 'tmux is not installed on remote';
    const r = await post('/api/respawn', { id: 'p' });
    assert.deepEqual(r, { status: 400, body: { error: 'tmux is not installed on remote' } });
    assert.deepEqual(preflightCalls, [LOCAL]);
    assert.deepEqual(calls(), []);
  });

  it('kills the stale session BEFORE creating the new one, and resolves a bare claude cmd to its full path', async () => {
    chatsById.c = tmuxChat('c', { cmd: 'claude --flag value', cwd: '/work' });
    markAlive('c');
    const r = await post('/api/respawn', { id: 'c' });
    assert.equal(r.status, 200);
    const order = subcommands();
    assert.ok(order.indexOf('kill-session') < order.indexOf('new-session'), order.join(','));
    assert.deepEqual(tmuxArgs('new-session'),
      ['new-session', '-d', '-s', 'c', '-x', '120', '-y', '32', '-c', '/work', claudeStub, '--flag', 'value']);
  });

  it('500s with the tmux error when new-session fails', async () => {
    chatsById.f = tmuxChat('f');
    fs.writeFileSync(newFailFile, '');
    const r = await post('/api/respawn', { id: 'f' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /boom: cannot create/);
  });

  it('500s "session died immediately" naming the binary when the session does not come up', async () => {
    chatsById.d = tmuxChat('d', { cmd: 'mytool --x' });
    fs.writeFileSync(newDiesFile, '');
    const r = await post('/api/respawn', { id: 'd' });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, '`mytool` failed to start on (local) — the session died immediately. Is it installed and on PATH there?');
  });
});

describe('POST /api/resume', () => {
  it('400s "invalid session id" for ids outside [\\w-]+ (including empty) and runs no tmux', async () => {
    for (const id of ['', 'a b', 'a;b', 'a.b', '../x']) {
      assert.deepEqual(await post('/api/resume', { id }), { status: 400, body: { error: 'invalid session id' } }, JSON.stringify(id));
    }
    assert.deepEqual(calls(), []);
  });

  it('names the session resume-<first 8 of id>, spawns claude --resume, catalogs it and records a resumed event', async () => {
    const sid = 'abcdef12-3456-7890';
    const r = await post('/api/resume', { id: sid, cwd: '/proj' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.chat.id, `${LOCAL}:resume-abcdef12`);
    assert.equal(r.body.chat.session, 'resume-abcdef12');
    assert.equal(r.body.chat.name, 'resume abcdef12');
    assert.equal(r.body.chat.cwd, '/proj');
    assert.equal(r.body.chat.container, null);
    assert.equal(r.body.chat.active, true);
    assert.deepEqual(tmuxArgs('new-session'),
      ['new-session', '-d', '-s', 'resume-abcdef12', '-x', '120', '-y', '32', '-c', '/proj',
        claudeStub, '--resume', sid, '--dangerously-skip-permissions']);
    assert.deepEqual(await loadCatalog(), [
      { kind: 'tmux', host: LOCAL, session: 'resume-abcdef12', name: 'resume abcdef12', cwd: '/proj', cmd: `${claudeStub} --resume ${sid} --dangerously-skip-permissions` },
    ]);
    const [ev] = await readEvents();
    assert.equal(ev.type, 'resumed');
    assert.equal(ev.id, `${LOCAL}:resume-abcdef12`);
    assert.equal(ev.name, 'resume abcdef12');
    assert.equal(ev.container, null);
  });

  it('trims a custom name and caps it at 80 chars', async () => {
    const r = await post('/api/resume', { id: 'sid1', cwd: '/p', name: `  ${'n'.repeat(100)}  ` });
    assert.equal(r.body.chat.name, 'n'.repeat(80));
    assert.equal((await loadCatalog())[0].name, 'n'.repeat(80));
  });

  it('defaults the local cwd to the server process cwd', async () => {
    const r = await post('/api/resume', { id: 'sid2' });
    assert.equal(r.body.chat.cwd, process.cwd());
  });

  it('kills a LIVE old resume session first, then spawns fresh (kill-session before new-session)', async () => {
    markAlive('resume-liveid12');
    const r = await post('/api/resume', { id: 'liveid12-extra', cwd: '/p' });
    assert.equal(r.status, 200);
    const order = subcommands().filter((s) => s !== 'has-session');
    assert.deepEqual(order, ['kill-session', 'new-session']);
    assert.deepEqual(tmuxArgs('kill-session'), ['kill-session', '-t', 'resume-liveid12']);
    assert.equal(isAlive('resume-liveid12'), true);
  });

  it('does not kill anything when no old resume session is alive', async () => {
    await post('/api/resume', { id: 'fresh123', cwd: '/p' });
    assert.deepEqual(callsOf('kill-session'), []);
  });

  it('replaces (not duplicates) the same host+session catalog entry and keeps other hosts', async () => {
    await saveCatalog([
      { kind: 'tmux', host: LOCAL, session: 'resume-dupdupdu', name: 'stale', cwd: '/old', cmd: 'old' },
      { kind: 'tmux', host: REMOTE, session: 'resume-dupdupdu', name: 'remote', cwd: '/r', cmd: 'r' },
      { kind: 'tmux', host: LOCAL, session: 'keep', name: 'keep' },
    ]);
    const r = await post('/api/resume', { id: 'dupdupdu-1', cwd: '/new' });
    assert.equal(r.status, 200);
    const cat = await loadCatalog();
    assert.equal(cat.length, 3);
    assert.equal(cat.filter((c) => c.host === LOCAL && c.session === 'resume-dupdupdu').length, 1);
    assert.equal(cat.find((c) => c.host === LOCAL && c.session === 'resume-dupdupdu').cwd, '/new');
    assert.equal(cat.find((c) => c.host === REMOTE).name, 'remote');
    assert.ok(cat.some((c) => c.session === 'keep'));
  });

  it('400s with the preflight error and creates no session or catalog entry', async () => {
    preflightError = 'no tmux';
    const r = await post('/api/resume', { id: 'pre12345', cwd: '/p' });
    assert.deepEqual(r, { status: 400, body: { error: 'no tmux' } });
    assert.deepEqual(callsOf('new-session'), []);
    assert.deepEqual(await loadCatalog(), []);
    assert.deepEqual(await readEvents(), []);
  });

  it('500s with the tmux error when new-session fails and writes no catalog entry', async () => {
    fs.writeFileSync(newFailFile, '');
    const r = await post('/api/resume', { id: 'fail1234', cwd: '/p' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /boom: cannot create/);
    assert.deepEqual(await loadCatalog(), []);
  });

  it('500s "tmux session died immediately" when the session does not come up and writes no catalog entry', async () => {
    fs.writeFileSync(newDiesFile, '');
    const r = await post('/api/resume', { id: 'dies1234', cwd: '/p' });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, '`claude` failed to start on (local) — tmux session died immediately. Is `claude` installed and on PATH there?');
    assert.deepEqual(await loadCatalog(), []);
  });
});

describe('POST /api/spawn', () => {
  it('400s "invalid session name" for an explicit session outside [A-Za-z0-9_-] (a dot included)', async () => {
    for (const session of ['a b', 'a.b', 'a:b', 'a/b']) {
      const r = await post('/api/spawn', { session, cmd: '' });
      assert.deepEqual(r, { status: 400, body: { error: 'invalid session name (letters/digits/_-)' } }, session);
    }
    assert.deepEqual(calls(), []);
  });

  it('409s when the same host+session is already cataloged and spawns nothing; another host is not a collision', async () => {
    await saveCatalog([{ kind: 'tmux', host: LOCAL, session: 'taken', name: 'taken' }]);
    const r = await post('/api/spawn', { session: 'taken', cmd: '' });
    assert.deepEqual(r, { status: 409, body: { error: '"taken" already exists' } });
    assert.deepEqual(callsOf('new-session'), []);
    // The same name on a different (preflight-passing) host is a different identity.
    const other = await post('/api/spawn', { session: 'taken', host: REMOTE, cmd: '' });
    assert.notEqual(other.status, 409);
  });

  it('400s with the preflight error and spawns nothing', async () => {
    preflightError = 'tmux missing';
    const r = await post('/api/spawn', { session: 's1', cmd: '' });
    assert.deepEqual(r, { status: 400, body: { error: 'tmux missing' } });
    assert.deepEqual(callsOf('new-session'), []);
    assert.deepEqual(await loadCatalog(), []);
  });

  it('500s "died immediately" naming the binary when the session does not come up, with no catalog entry', async () => {
    fs.writeFileSync(newDiesFile, '');
    const r = await post('/api/spawn', { session: 's2', cmd: 'mytool --x' });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, '`mytool` failed to start on (local) — the session died immediately. Is it installed and on PATH there?');
    assert.deepEqual(await loadCatalog(), []);
  });

  it('500s with the tmux error when new-session fails', async () => {
    fs.writeFileSync(newFailFile, '');
    const r = await post('/api/spawn', { session: 's3', cmd: '' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /boom: cannot create/);
  });

  it('a NAMED spawn without a cmd defaults to claude (resolved to its full path) and is cataloged persistent', async () => {
    const r = await post('/api/spawn', { session: 'named1', cwd: '/w' });
    assert.equal(r.status, 200);
    const expectedCmd = `${claudeStub} --dangerously-skip-permissions`;
    assert.equal(r.body.chat.cmd, expectedCmd);
    assert.equal(r.body.chat.id, `${LOCAL}:named1`);
    assert.equal(r.body.chat.name, 'named1');
    assert.equal(r.body.chat.temporary, undefined);
    assert.deepEqual(tmuxArgs('new-session'),
      ['new-session', '-d', '-s', 'named1', '-x', '120', '-y', '32', '-c', '/w', claudeStub, '--dangerously-skip-permissions']);
    // The catalog stores the RAW user-level cmd (bare claude), not the resolved path.
    assert.deepEqual(await loadCatalog(), [{ kind: 'tmux', host: LOCAL, session: 'named1', name: 'named1', cwd: '/w', cmd: 'claude --dangerously-skip-permissions' }]);
  });

  it('an EXPLICIT empty cmd is honored (no command args), even for a named spawn', async () => {
    const r = await post('/api/spawn', { session: 'plain', cwd: '/w', cmd: '' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.cmd, '');
    assert.deepEqual(tmuxArgs('new-session'), ['new-session', '-d', '-s', 'plain', '-x', '120', '-y', '32', '-c', '/w']);
  });

  it('derives the tmux id from a human name (runs of unsafe chars -> "-", leading/trailing separators stripped) and keeps the raw display name', async () => {
    const r = await post('/api/spawn', { name: '  release train 0.1.75 / ', cwd: '/w', cmd: '' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.session, 'release-train-0-1-75');
    assert.equal(r.body.chat.name, 'release train 0.1.75 /');
    assert.deepEqual(tmuxArgs('new-session').slice(0, 4), ['new-session', '-d', '-s', 'release-train-0-1-75']);
    assert.equal(isAlive('release-train-0-1-75'), true);
  });

  it('an omitted session AND name makes a TEMPORARY shell-xxxxxx session with an empty cmd, flagged temporary in the response and catalog', async () => {
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.equal(r.status, 200);
    assert.match(r.body.chat.session, /^shell-[a-z0-9]{1,6}$/);
    assert.equal(r.body.chat.temporary, true);
    assert.equal(r.body.chat.cmd, '');
    const [entry] = await loadCatalog();
    assert.equal(entry.temporary, true);
    assert.equal(entry.session, r.body.chat.session);
    assert.deepEqual(callsOf('new-session')[0].slice(0, 4), ['new-session', '-d', '-s', r.body.chat.session]);
  });

  it('quotes a resolved claude path containing a space so it stays ONE argv element (WARDEN-922)', async () => {
    process.env.CLAUDE_CODE_EXECPATH = claudeSpaced;
    const r = await post('/api/spawn', { session: 'spaced', cwd: '/w' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.cmd, `"${claudeSpaced}" --dangerously-skip-permissions`);
    const argv = tmuxArgs('new-session');
    assert.deepEqual(argv.slice(-2), [claudeSpaced, '--dangerously-skip-permissions']);
  });

  it('records a spawned event with the chat id, host, role and name', async () => {
    await post('/api/spawn', { session: 'ev1', name: 'Evented', cwd: '/w', cmd: '' });
    const [ev] = await readEvents();
    assert.equal(ev.type, 'spawned');
    assert.equal(ev.id, `${LOCAL}:ev1`);
    assert.equal(ev.host, LOCAL);
    assert.equal(ev.container, null);
    assert.equal(ev.role, 'claude');
    assert.equal(ev.name, 'Evented');
  });

  it('an unwritable activity log does not turn a completed spawn into a 500', async () => {
    fs.mkdirSync(activityFile, { recursive: true });
    const r = await post('/api/spawn', { session: 'noevent', cwd: '/w', cmd: '' });
    assert.equal(r.status, 200);
    assert.equal((await loadCatalog()).length, 1);
  });
});
