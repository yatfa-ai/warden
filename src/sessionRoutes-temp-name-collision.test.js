import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// WARDEN-2090 — pins the temporary-shell name REDRAW loop in POST /api/spawn
// (src/sessionRoutes.js): when the caller sends neither a session nor a name the
// spawn is TEMPORARY and its tmux name is GENERATED (`newTempName` → `shell-` +
// 6 base-36 chars). The comment on the loop states the contract: the caller
// never chose the name, so a same-host catalog collision must be retried with a
// fresh draw instead of 409ing; the loop re-draws at most five times and then
// falls through to the pre-flight 409, and a generated name on a DIFFERENT host
// is not a collision at all. `sessionRoutes.test.js` covers this route well but
// never executes the loop body — its 409 test uses an EXPLICIT session name,
// which skips the loop entirely (`temporary` is false).
//
// The harness below is copied verbatim from src/sessionRoutes.test.js (the real
// router on a bare express() app, a fake `tmux` on PATH that logs argv and
// models liveness with marker files, HOME frozen to a temp dir before the
// dynamic imports — config.js/activity.js compute paths from os.homedir() at
// load). The one addition: `Math.random` is scripted with `mock.method` so each
// `newTempName` draw is deterministic. Nothing else on this request path draws
// (the only other Math.random users in src/ are collections.js and retry.js,
// neither reached by /api/spawn), so scripted values map 1:1 to draws; once the
// script is exhausted the mock falls back to the real Math.random, and
// `mock.restoreAll()` in afterEach undoes the replacement.

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  COMPANION: process.env.WARDEN_COMPANION_TRANSPORT,
  EXECPATH: process.env.CLAUDE_CODE_EXECPATH,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sessionRoutes-temp-'));
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

const LOCAL = '(local)';
const REMOTE = 'user@other.example';

const calls = () => fs.readFileSync(logFile, 'utf8')
  .split('\n').filter((l) => l.length > 0)
  .map((l) => l.split('\x1f').slice(0, -1));
const callsOf = (sub) => calls().filter((a) => a[0] === sub);
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
  await saveCatalog([]);
});

afterEach(() => {
  mock.restoreAll();
});

// The name a draw produces — the SAME expression as newTempName in
// src/sessionRoutes.js, so expected names are computed, never hard-coded.
const tempName = (r) => `shell-${r.toString(36).slice(2, 8)}`;

const catalogEntry = (session, host = LOCAL, extra = {}) =>
  ({ kind: 'tmux', host, session, name: session, cwd: '/w', cmd: '', ...extra });

let randomMock;
// Script the next newTempName draws. Falls back to the real Math.random once
// the script is exhausted, so an over-draw fails the count assertion rather
// than hanging or colliding silently.
const drawNames = (...values) => {
  let i = 0;
  const realRandom = Math.random;
  randomMock = mock.method(Math, 'random', () => (i < values.length ? values[i++] : realRandom()));
};
const drawn = () => randomMock.mock.callCount();

describe('POST /api/spawn temporary-shell name redraw', () => {
  it('keeps the first draw when nothing collides and consumes exactly one random value', async () => {
    drawNames(0.5);
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.session, tempName(0.5));
    assert.equal(r.body.chat.temporary, true);
    assert.equal(drawn(), 1);
    assert.deepEqual(tmuxArgs('new-session').slice(0, 4), ['new-session', '-d', '-s', tempName(0.5)]);
  });

  it('re-draws once on a same-host collision: the second name is spawned and cataloged temporary', async () => {
    await saveCatalog([catalogEntry(tempName(0.1))]);
    drawNames(0.1, 0.2);
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.session, tempName(0.2));
    assert.equal(r.body.chat.temporary, true);
    assert.equal(drawn(), 2);
    assert.deepEqual(tmuxArgs('new-session').slice(0, 4), ['new-session', '-d', '-s', tempName(0.2)]);
    const cat = await loadCatalog();
    assert.equal(cat.length, 2);
    assert.ok(cat.some((c) => c.host === LOCAL && c.session === tempName(0.1)), 'seeded entry kept');
    assert.ok(cat.some((c) => c.host === LOCAL && c.session === tempName(0.2) && c.temporary === true), 'redrawn entry cataloged');
  });

  it('does not re-draw when the generated name exists only on a DIFFERENT host', async () => {
    await saveCatalog([catalogEntry(tempName(0.3), REMOTE)]);
    drawNames(0.3);
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.session, tempName(0.3));
    assert.equal(drawn(), 1);
    // Both hosts now hold the same generated name — composite identity means
    // neither blocked the other.
    const cat = await loadCatalog();
    assert.equal(cat.filter((c) => c.session === tempName(0.3)).length, 2);
  });

  it('re-draws through five same-host collisions and accepts the sixth name', async () => {
    const draws = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66];
    await saveCatalog(draws.slice(0, 5).map((v) => catalogEntry(tempName(v))));
    drawNames(...draws);
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.equal(r.status, 200);
    assert.equal(r.body.chat.session, tempName(0.66));
    assert.equal(r.body.chat.temporary, true);
    assert.equal(drawn(), 6);
    assert.equal((await loadCatalog()).length, 6);
  });

  it('gives up after five re-draws: the 409 names the sixth draw and no seventh is made', async () => {
    const draws = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66];
    await saveCatalog(draws.map((v) => catalogEntry(tempName(v))));
    drawNames(...draws);
    const r = await post('/api/spawn', { cwd: '/w' });
    assert.deepEqual(r, { status: 409, body: { error: `"${tempName(0.66)}" already exists` } });
    assert.equal(drawn(), 6);
    assert.deepEqual(callsOf('new-session'), []);
  });

  it('an explicit colliding session still 409s under its own name and draws nothing', async () => {
    await saveCatalog([catalogEntry('taken')]);
    drawNames(0.5);
    const r = await post('/api/spawn', { session: 'taken', cmd: '' });
    assert.deepEqual(r, { status: 409, body: { error: '"taken" already exists' } });
    assert.equal(drawn(), 0);
    assert.deepEqual(callsOf('new-session'), []);
  });
});
