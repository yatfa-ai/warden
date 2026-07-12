import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Cross-host lifecycle poll — agent_ended must still fire when the fleet empties.
 *
 * Regression for WARDEN-147. tickLifecycle()'s no-hosts-no-catalog guard used to
 * be a bare `return`, which short-circuited BEFORE diffing prevSnapshot against
 * the now-empty fleet. So when the last agent ended (or the user removed their
 * last configured host), the pending disappearance in prevSnapshot was never
 * diffed → the final agent_ended was permanently suppressed, or emitted minutes
 * late with a wrong timestamp once some OTHER agent later reappeared (the only
 * thing that un-froze the diff). The fix drains pending transitions against an
 * empty snapshot before going dormant.
 *
 * We drive the REAL tickLifecycle() against a local catalog chat whose `active`
 * state is a live local tmux session — the exact same discoverAll() code path
 * cross-host yatfa agents flow through (runLocalTmux has-session), so no SSH/docker
 * host is needed. Isolated HOME so the catalog + activity log don't collide with
 * anything real. node --test runs each file in its own process, so the HOME swap
 * and module-level prevSnapshot don't leak.
 */

describe('cross-host lifecycle poll — drains agent_ended when the catalog empties (WARDEN-147)', () => {
  let httpServer, tickLifecycle;
  let originalHome, tempHome, catPath, activityPath;
  const SESSION = 'w147drain';

  function seedCatalog(entries) {
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  }
  function readActivity() {
    try {
      return fs.readFileSync(activityPath, 'utf8')
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-life-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    // No remote hosts → the lifecycle poll's only source is the local catalog.
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    activityPath = path.join(wdir, 'activity.jsonl');
    seedCatalog([]);
    fs.writeFileSync(activityPath, '');

    // A live local tmux session → discoverAll reports this catalog chat as active.
    // Safety net first: kill a stale session by EXACT name (a tmux op, never a
    // command-line pattern that could match this agent's own shell).
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    const spawned = spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24'], { stdio: 'ignore' });
    assert.strictEqual(spawned.status, 0, 'fixture tmux session must start');

    // Dynamic import AFTER HOME is set → config/catalog/activity paths resolve
    // under tempHome, and module-level prevSnapshot starts empty.
    const { app, tickLifecycle: tick } = await import('./server.js');
    tickLifecycle = tick;
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
  });

  after(async () => {
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits agent_ended for a tracked chat when the catalog empties out', async () => {
    // 1. Catalog has one active local chat. First tick SEEDS prevSnapshot silently
    //    (no burst of agent_started).
    seedCatalog([{ kind: 'tmux', host: '(local)', session: SESSION, name: SESSION, cwd: '/tmp', cmd: 'claude' }]);
    await tickLifecycle();
    assert.deepStrictEqual(readActivity(), [], 'first run seeds silently (no burst)');

    // 2. Empty the catalog AND tear down the session → the fleet is now empty
    //    (no remote hosts, no catalog). prevSnapshot still tracks the chat.
    seedCatalog([]);
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });

    // 3. Next tick: the no-hosts-no-catalog guard MUST drain the pending
    //    disappearance against an empty snapshot before going dormant — not bare
    //    `return`. On the buggy build this emits nothing; on the fixed build it
    //    emits agent_ended for the chat.
    await tickLifecycle();
    const ended = readActivity().filter((e) => e.type === 'agent_ended');
    assert.strictEqual(ended.length, 1, 'the drained chat produces exactly one agent_ended');
    assert.strictEqual(ended[0].id, `(local):${SESSION}`);
    assert.strictEqual(ended[0].host, '(local)', 'event is host-attributed (host-filterable)');

    // 4. A subsequent empty tick must NOT re-emit: prevSnapshot was reset to empty
    //    by the drain, so there is nothing left to diff.
    await tickLifecycle();
    const endedAfterReset = readActivity().filter((e) => e.type === 'agent_ended');
    assert.strictEqual(endedAfterReset.length, 1, 'no duplicate agent_ended after snapshot reset');
  });
});
