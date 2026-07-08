import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { summarizeOpenChats, Observer } from './observer.js';

// Shared config passed through to capturePanes.
const cfg = { hosts: [] };

// Builder for a yatfa (docker) chat: container set, session 'agent'.
function yatfaChat(overrides = {}) {
  return {
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
    ...overrides,
  };
}

// Builder for a manual/tmux chat: container null, session is the target.
function tmuxChat(overrides = {}) {
  return {
    id: '(local):manual-session',
    key: 'manual-session',
    kind: 'tmux',
    host: '(local)',
    container: null,
    session: 'manual-session',
    project: 'local',
    role: 'claude',
    active: true,
    status: 'running',
    ...overrides,
  };
}

describe('summarizeOpenChats', () => {
  describe('empty tabs path (open.size === 0)', () => {
    it('returns the "no tabs" error when openTabs is undefined', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(undefined, [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error, 'should return an error');
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "no tabs" error when openTabs is null', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(null, [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "no tabs" error when openTabs is an empty array', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats([], [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });
  });

  describe('stale state path (openChats.length === 0)', () => {
    it('returns the "do not match" error when no open tab matches a discovered chat', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(['ghost-tab'], [yatfaChat()], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });

    it('returns the "do not match" error when lastChats is empty', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await summarizeOpenChats(['myproject-worker'], [], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0, 'should not call capturePanes');
    });
  });

  describe('success path', () => {
    it('returns structured metadata + pane content for each open chat', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'worker pane content' }));

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(result.count, 1);
      assert.ok(Array.isArray(result.chats));
      assert.strictEqual(result.chats.length, 1);

      const entry = result.chats[0];
      assert.strictEqual(entry.id, 'myproject-worker', 'id is container || session');
      assert.strictEqual(entry.host, 'host1');
      assert.strictEqual(entry.project, 'myproject');
      assert.strictEqual(entry.role, 'worker');
      assert.strictEqual(entry.active, true);
      assert.strictEqual(entry.status, 'running');
      assert.strictEqual(entry.pane, 'worker pane content');
    });

    it('calls capturePanes once with the filtered open chats and the cfg', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'x' }));

      await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(capturePanes.mock.callCount(), 1);
      const call = capturePanes.mock.calls[0];
      assert.strictEqual(call.arguments[0].length, 1, 'passes the single open chat');
      assert.strictEqual(call.arguments[0][0].key, 'myproject-worker');
      assert.strictEqual(call.arguments[1], cfg, 'forwards cfg');
    });

    it('id falls back to session when container is null (manual/tmux chat)', async () => {
      const chat = tmuxChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'manual pane' }));

      const result = await summarizeOpenChats([chat.session], [chat], capturePanes, cfg);

      assert.strictEqual(result.chats[0].id, 'manual-session');
      assert.strictEqual(result.chats[0].pane, 'manual pane');
    });

    it('pane falls back to "(no pane content)" when the key is missing from the panes map', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => ({})); // no panes captured

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(result.chats[0].pane, '(no pane content)');
    });
  });

  describe('chat filtering logic (open.has(container || session) || open.has(key))', () => {
    const panesFn = mock.fn(async (chats) =>
      Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));

    it('matches a yatfa chat by container', async () => {
      const result = await summarizeOpenChats(['myproject-worker'], [yatfaChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
    });

    it('matches a manual chat by session (container is null)', async () => {
      const result = await summarizeOpenChats(['manual-session'], [tmuxChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
    });

    it('matches a chat by key', async () => {
      const result = await summarizeOpenChats(['myproject-worker'], [yatfaChat()], panesFn, cfg);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.chats[0].pane, 'pane-myproject-worker');
    });

    it('summarizes only chats whose tab is open (closed chats are excluded)', async () => {
      const worker = yatfaChat();
      const researcher = yatfaChat({
        id: 'host1:myproject-researcher',
        key: 'myproject-researcher',
        container: 'myproject-researcher',
        role: 'researcher',
      });

      const fn = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));
      const result = await summarizeOpenChats(['myproject-worker'], [worker, researcher], fn, cfg);

      assert.strictEqual(result.count, 1, 'only the open worker tab');
      assert.strictEqual(result.chats[0].id, 'myproject-worker');
      // capturePanes only sees the one open chat
      assert.strictEqual(fn.mock.calls[0].arguments[0].length, 1);
    });

    it('summarizes all open chats when multiple tabs are open', async () => {
      const worker = yatfaChat();
      const researcher = yatfaChat({
        id: 'host1:myproject-researcher',
        key: 'myproject-researcher',
        container: 'myproject-researcher',
        role: 'researcher',
      });

      const fn = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, `pane-${c.key}`])));
      const result = await summarizeOpenChats(
        ['myproject-worker', 'myproject-researcher'],
        [worker, researcher],
        fn,
        cfg,
      );

      assert.strictEqual(result.count, 2);
      const ids = result.chats.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, ['myproject-researcher', 'myproject-worker']);
    });
  });

  describe('error handling', () => {
    it('returns the error message when capturePanes throws', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => {
        throw new Error('ssh connection refused');
      });

      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.error, 'ssh connection refused');
    });

    it('does not throw when capturePanes rejects (error is captured, not propagated)', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => {
        throw new Error('boom');
      });

      // Must resolve rather than reject — the handler swallows the throw.
      const result = await summarizeOpenChats([chat.container], [chat], capturePanes, cfg);

      assert.ok(result.error);
      assert.strictEqual(result.count, undefined, 'success shape not produced');
    });
  });
});

describe('Observer _execTool summarize_chats dispatch', () => {
  it('returns the empty-tabs error when openTabs is empty', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = [];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });

  it('returns the stale-state error when open tabs do not match any chat', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = ['ghost-tab'];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
  });

  it('treats an unset openTabs as empty', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('summarize_chats', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });
});
