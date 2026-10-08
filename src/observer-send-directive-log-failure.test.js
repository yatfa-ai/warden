import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1658 — send_directive must not report { error } once the directive was
 * already delivered to the pane and only the post-send bookkeeping (directives.md /
 * activity.jsonl) failed. Otherwise the Observer LLM sees a failure and may retry,
 * typing the same directive into the pane twice.
 *
 * DIRECTIVES_LOG / activity paths are pinned from os.homedir() at module load, so
 * HOME is redirected BEFORE the dynamic imports. Failure injection: the log target is
 * a DIRECTORY, so the append fails with EISDIR deterministically (also as root).
 */

const chat = {
  id: 'host1:myproject-worker', key: 'myproject-worker', kind: 'yatfa', host: 'host1',
  container: 'myproject-worker', session: 'agent', project: 'myproject', role: 'worker',
  active: true, status: 'running',
};

describe('WARDEN-1658 — send_directive survives post-send log failures', () => {
  let savedHome, tempHome, wdir, Observer, logDirective, DIRECTIVES_LOG, directivesPath, activityPath;

  before(async () => {
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-senddir-logfail-'));
    process.env.HOME = tempHome;
    wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    ({ Observer, logDirective, DIRECTIVES_LOG } = await import('./observer.js'));
    directivesPath = DIRECTIVES_LOG;
    activityPath = path.join(wdir, 'activity.jsonl');
    assert.ok(directivesPath.startsWith(tempHome), 'log paths must be redirected into the temp HOME');
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    for (const p of [directivesPath, activityPath]) fs.rmSync(p, { recursive: true, force: true });
  });

  function makeObserver(sendPane) {
    const io = { resolveChat: () => ({ chat }), sendPane };
    const obs = new Observer({ hosts: [] }, { io, gate: async () => ({ approved: true }) });
    obs.lastChats = [chat];
    return obs;
  }
  const run = (obs) => obs._execTool('send_directive', { id: 'myproject-worker', directive: 'ship it' });

  it('(d) positive control: logDirective really rejects when directives.md is a directory', async () => {
    fs.mkdirSync(directivesPath);
    await assert.rejects(() => logDirective(chat, 'probe'));
  });

  it('(a) directives.md is a directory → still sent: true, sendPane called once', async () => {
    fs.mkdirSync(directivesPath);
    const sendPane = mock.fn(async () => undefined);
    const result = await run(makeObserver(sendPane));
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.to, 'myproject-worker@host1');
    assert.strictEqual(result.chars, 'ship it'.length);
    assert.strictEqual(sendPane.mock.callCount(), 1);
    // logDirective failing must not stop the activity event being attempted.
    assert.match(fs.readFileSync(activityPath, 'utf8'), /directive_sent/);
  });

  it('(b) activity.jsonl is a directory → still sent: true, sendPane called once', async () => {
    fs.mkdirSync(activityPath);
    const sendPane = mock.fn(async () => undefined);
    const result = await run(makeObserver(sendPane));
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sendPane.mock.callCount(), 1);
    assert.match(fs.readFileSync(directivesPath, 'utf8'), /ship it/);
  });

  it('(c) sendPane rejects → { error }, neither log written', async () => {
    const sendPane = mock.fn(async () => { throw new Error('tmux send failed'); });
    const result = await run(makeObserver(sendPane));
    assert.deepStrictEqual(result, { error: 'tmux send failed' });
    assert.strictEqual(sendPane.mock.callCount(), 1);
    assert.strictEqual(fs.existsSync(directivesPath), false);
    assert.strictEqual(fs.existsSync(activityPath), false);
  });
});
