import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1880 — test isolation: the send_directive success path and the three
 * persisted-session resume tests write the ~/.yatfa-warden data directory, and
 * the data-dir constants are pinned from os.homedir() at module load
 * (observer.js DIRECTIVES_LOG/DATA_DIR, sessions.js DIR, activity.js DIR).
 * observer.test.js statically imports those modules for ~40 other tests, so it
 * cannot redirect HOME in place — an already-imported module keeps its real-HOME
 * pins — and it papered over this with a snapshot/restore that is not hermetic:
 * an interrupted run (Ctrl-C, crash, CI timeout) skips the restore entirely, and
 * the restore itself is a blind read-modify-write that silently destroys anything
 * appended concurrently, including a live server's real activity/directive
 * events.
 *
 * This file is the sanctioned answer (WARDEN-1071 Principle 2, same pattern as
 * the direct sibling observer-send-directive-log-failure.test.js): HOME is
 * redirected to a throwaway dir BEFORE the dynamic imports, so the freshly
 * loaded module instances pin their paths to the temp home. No production file
 * is touched, and nothing under the real ~/.yatfa-warden is ever written.
 *
 * The redirect also makes the success path's post-send bookkeeping assertable:
 * directives.md and activity.jsonl land in the temp dir, so the moved test now
 * checks the two log writes it previously performed but never verified.
 */

// Same yatfa (docker) chat shape the moved tests used (observer.test.js
// yatfaChat()): container set, session 'agent'.
const chat = {
  id: 'host1:myproject-worker',
  key: 'myproject-worker',
  kind: 'yatfa',
  host: 'host1',
  container: 'myproject-worker',
  session: 'agent',
  project: 'myproject',
  role: 'worker',
  active: true,
  status: 'running',
};

// Shared config passed through to capturePanes (same as observer.test.js cfg).
const cfg = { hosts: [] };

describe('Observer send_directive + persisted-session resume (redirected HOME — WARDEN-1880)', () => {
  let savedHome, tempHome, wdir;
  let Observer, DIRECTIVES_LOG, createSession, deleteSession;
  let directivesPath, activityPath;

  before(async () => {
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-observer-1880-'));
    process.env.HOME = tempHome;
    wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    // Dynamic imports AFTER the HOME redirect: fresh module instances pin their
    // data-dir constants to the temp home.
    ({ Observer, DIRECTIVES_LOG } = await import('./observer.js'));
    ({ createSession, deleteSession } = await import('./sessions.js'));
    directivesPath = path.join(wdir, 'directives.md');
    activityPath = path.join(wdir, 'activity.jsonl');
    // Positive control: the pins must live in the temp home, or the redirect
    // failed and every test below would write the real data dir.
    assert.ok(DIRECTIVES_LOG.startsWith(tempHome), 'log paths must be redirected into the temp HOME');
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // io bag whose deps throw if reached: each test overrides only the dep(s) its
  // dispatch path should actually touch, so an accidental detour fails loudly
  // instead of silently no-op'ing. (Copied from observer.test.js makeIo.)
  function makeIo(overrides = {}) {
    const boom = () => { throw new Error('unexpected io dep reached for this dispatch path'); };
    return {
      discoverAll: boom,
      capturePanes: boom,
      resolveChat: boom,
      readPane: boom,
      sendPane: boom,
      ...overrides,
    };
  }

  describe('Observer _execTool send_directive (success)', () => {
    it('send_directive success: gate approves and the directive is sent via the injected sendPane', async () => {
      const resolveChat = mock.fn(() => ({ chat }));
      const sendPane = mock.fn(async () => undefined);
      const gate = mock.fn(async () => ({ approved: true }));
      const obs = new Observer(cfg, { io: makeIo({ resolveChat, sendPane }), gate });
      obs.lastChats = [chat];

      const result = await obs._execTool('send_directive', { id: 'myproject-worker', directive: 'ship it' });

      assert.strictEqual(resolveChat.mock.callCount(), 1, '_resolve routed through this._io.resolveChat, not the live import');
      assert.strictEqual(gate.mock.callCount(), 1, 'the gate was consulted');
      assert.strictEqual(gate.mock.calls[0].arguments[0], chat, 'gate received the resolved chat');
      assert.strictEqual(gate.mock.calls[0].arguments[1], 'ship it', 'gate received the directive text');
      assert.strictEqual(sendPane.mock.callCount(), 1, 'dispatch reached the injected sendPane, not the live import');
      assert.strictEqual(sendPane.mock.calls[0].arguments[0], chat, 'sendPane received the resolved chat');
      assert.strictEqual(sendPane.mock.calls[0].arguments[2], 'ship it', 'sendPane received the approved directive text');
      assert.strictEqual(result.sent, true);
      assert.strictEqual(result.to, 'myproject-worker@host1');
      assert.strictEqual(result.chars, 'ship it'.length);
      // WARDEN-1880: with the redirected HOME the success path's post-send
      // bookkeeping is assertable instead of being snapshot/restored away —
      // both log writes land in the temp data dir.
      assert.match(fs.readFileSync(directivesPath, 'utf8'), /ship it/,
        'the directive was recorded in directives.md under the temp data dir');
      assert.match(fs.readFileSync(activityPath, 'utf8'), /directive_sent/,
        'the send was recorded as a directive_sent event in activity.jsonl under the temp data dir');
    });
  });

  describe('Observer chat context (persisted-session resume)', () => {
    it('restores chat context from the persisted session on resume', async () => {
      const s = await createSession(null, { host: 'host1', container: 'c1', project: 'p', role: 'worker', chatKey: 'c1' });
      try {
        const obs = new Observer(cfg, { sid: s.id }); // resume path: sid set, no chatContext
        assert.strictEqual(obs.boundKey, 'c1');
        assert.strictEqual(obs.getChatContext().host, 'host1');
        assert.strictEqual(obs.getChatContext().role, 'worker');
      } finally {
        await deleteSession(s.id);
      }
    });

    it('persisted session context takes precedence over a passed chatContext on resume', async () => {
      const s = await createSession(null, { host: 'host1', container: 'c1', chatKey: 'c1', role: 'worker' });
      try {
        const obs = new Observer(cfg, { sid: s.id, chatContext: { container: 'OTHER', chatKey: 'OTHER' } });
        assert.strictEqual(obs.boundKey, 'c1', 'the persisted context is the source of truth');
      } finally {
        await deleteSession(s.id);
      }
    });

    it('a legacy session without chat context resumes unbound (backward compatible)', async () => {
      const s = await createSession(null); // no context
      try {
        const obs = new Observer(cfg, { sid: s.id });
        assert.strictEqual(obs.boundKey, null);
        assert.strictEqual(obs.getChatContext(), null);
      } finally {
        await deleteSession(s.id);
      }
    });
  });
});
