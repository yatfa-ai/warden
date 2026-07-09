import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { summarizeOpenChats, suggestNextActions, Observer, TOOLS } from './observer.js';

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

describe('suggest_next_actions tool registration', () => {
  it('is registered in the TOOLS array with an object input schema', () => {
    const tool = TOOLS.find((t) => t.name === 'suggest_next_actions');
    assert.ok(tool, 'suggest_next_actions tool should be registered');
    assert.strictEqual(tool.input_schema.type, 'object');
    assert.deepStrictEqual(tool.input_schema.required, []);
  });
});

describe('Observer _execTool suggest_next_actions dispatch', () => {
  it('returns the empty-tabs error when openTabs is empty', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = [];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });

  it('returns the stale-state error when open tabs do not match any chat', async () => {
    const obs = new Observer(cfg, {});
    obs.openTabs = ['ghost-tab'];
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
  });

  it('treats an unset openTabs as empty', async () => {
    const obs = new Observer(cfg, {});
    obs.lastChats = [yatfaChat()];

    const result = await obs._execTool('suggest_next_actions', {});

    assert.ok(result.error);
    assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
  });
});

describe('suggestNextActions (pure classifier)', () => {
  // Run classification for a single open chat with the given pane content.
  async function classify(pane, chatOverrides = {}) {
    const chat = yatfaChat(chatOverrides);
    const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: pane }));
    const result = await suggestNextActions([chat.container], [chat], capturePanes, cfg);
    return { result, capturePanes };
  }

  describe('classification of agent states', () => {
    it('classifies an erroring agent as urgent', async () => {
      const { result } = await classify(
        'Running tests...\nError: test suite failed with exit code 1\nSee traceback above.'
      );
      assert.strictEqual(result.suggestions[0].state, 'erroring');
      assert.strictEqual(result.suggestions[0].urgency, 'urgent');
      assert.strictEqual(result.summary.urgent, 1);
    });

    it('classifies a stuck agent (repeating output) as urgent', async () => {
      const line = 'Retrying connection to host in 5 seconds...';
      const pane = Array(6).fill(line).join('\n');
      const { result } = await classify(pane);
      assert.strictEqual(result.suggestions[0].state, 'stuck');
      assert.strictEqual(result.suggestions[0].urgency, 'urgent');
    });

    it('classifies a blocked agent (coordination dependency) as important', async () => {
      const { result } = await classify(
        'Cannot proceed: blocked by the planner. Depends on the design doc being finished.'
      );
      assert.strictEqual(result.suggestions[0].state, 'blocked');
      assert.strictEqual(result.suggestions[0].urgency, 'important');
    });

    it('classifies a waiting agent (human input) as important', async () => {
      const { result } = await classify(
        'I need your input to continue. Please respond with your decision, or press enter for the default.'
      );
      assert.strictEqual(result.suggestions[0].state, 'waiting');
      assert.strictEqual(result.suggestions[0].urgency, 'important');
    });

    it('classifies an active agent as informational', async () => {
      const { result } = await classify(
        'Installing dependencies...\nBuilding the project...\nRunning the test suite now.'
      );
      assert.strictEqual(result.suggestions[0].state, 'active');
      assert.strictEqual(result.suggestions[0].urgency, 'informational');
    });

    it('classifies an idle agent with minimal output as informational', async () => {
      const { result } = await classify('Ready.', { active: false });
      assert.strictEqual(result.suggestions[0].state, 'idle');
      assert.strictEqual(result.suggestions[0].urgency, 'informational');
    });
  });

  describe('waiting vs blocked (WARDEN-43 Issue 2 regression)', () => {
    it('classifies "waiting for user" as waiting, NOT blocked', async () => {
      const { result } = await classify(
        'I need your input to continue. waiting for user input'
      );
      assert.notStrictEqual(result.suggestions[0].state, 'blocked',
        '"waiting for user" must not be misclassified as blocked');
      assert.strictEqual(result.suggestions[0].state, 'waiting');
    });

    it('still classifies coordination blockers (e.g. "waiting for the planner") as blocked', async () => {
      const { result } = await classify(
        'Holding here — waiting for the planner to deliver the spec before I start.'
      );
      assert.strictEqual(result.suggestions[0].state, 'blocked');
    });
  });

  describe('urgency sort', () => {
    it('sorts suggestions urgent → important → informational', async () => {
      const worker = yatfaChat({ id: 'host1:proj-worker', key: 'proj-worker', container: 'proj-worker', role: 'worker' });
      const reviewer = yatfaChat({ id: 'host1:proj-reviewer', key: 'proj-reviewer', container: 'proj-reviewer', role: 'reviewer' });
      const planner = yatfaChat({ id: 'host1:proj-planner', key: 'proj-planner', container: 'proj-planner', role: 'planner' });

      const panes = {
        'proj-worker': 'Error: build failed',               // urgent (erroring)
        'proj-reviewer': 'Please respond with your approval.', // important (waiting)
        'proj-planner': 'Ready.',                            // informational (idle)
      };
      const capturePanes = mock.fn(async (chats) =>
        Object.fromEntries(chats.map((c) => [c.key, panes[c.key]])));

      const result = await suggestNextActions(
        ['proj-worker', 'proj-reviewer', 'proj-planner'],
        [worker, reviewer, planner],
        capturePanes,
        cfg,
      );

      assert.deepStrictEqual(result.suggestions.map((s) => s.state),
        ['erroring', 'waiting', 'idle']);
      assert.deepStrictEqual(result.suggestions.map((s) => s.urgency),
        ['urgent', 'important', 'informational']);
    });
  });

  describe('cfg forwarding (WARDEN-43 Issue 1)', () => {
    it('forwards cfg to capturePanes (previously dropped)', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async (chats) => ({ [chats[0].key]: 'Ready.' }));
      await suggestNextActions([chat.container], [chat], capturePanes, cfg);

      assert.strictEqual(capturePanes.mock.callCount(), 1);
      assert.strictEqual(capturePanes.mock.calls[0].arguments[1], cfg,
        'capturePanes must receive cfg for parity with summarize_chats / analyze_agents');
    });
  });

  describe('guard paths', () => {
    it('returns the empty-tabs error when openTabs is empty (no capturePanes call)', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await suggestNextActions([], [yatfaChat()], capturePanes, cfg);
      assert.strictEqual(result.error, 'no tabs are open. open some agent panes first.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('returns the stale-state error when open tabs match no chat (no capturePanes call)', async () => {
      const capturePanes = mock.fn(async () => ({}));
      const result = await suggestNextActions(['ghost-tab'], [yatfaChat()], capturePanes, cfg);
      assert.strictEqual(result.error, 'open tabs do not match any discovered chats. try refreshing with list_chats.');
      assert.strictEqual(capturePanes.mock.callCount(), 0);
    });

    it('captures capturePanes errors without throwing', async () => {
      const chat = yatfaChat();
      const capturePanes = mock.fn(async () => { throw new Error('ssh refused'); });
      const result = await suggestNextActions([chat.container], [chat], capturePanes, cfg);
      assert.strictEqual(result.error, 'ssh refused');
    });
  });

  describe('suggestion shape', () => {
    it('populates agentId/agentName/role/project/host/state/urgency/action on each suggestion', async () => {
      const { result } = await classify('Error: something failed');
      const s = result.suggestions[0];
      assert.strictEqual(s.agentId, 'myproject-worker');
      assert.strictEqual(s.agentName, 'myproject-worker');
      assert.strictEqual(s.role, 'worker');
      assert.strictEqual(s.project, 'myproject');
      assert.strictEqual(s.host, 'host1');
      assert.strictEqual(s.state, 'erroring');
      assert.strictEqual(s.urgency, 'urgent');
      assert.ok(typeof s.action === 'string' && s.action.length > 0);
      assert.ok(typeof s.pane_excerpt === 'string');
    });
  });
});
